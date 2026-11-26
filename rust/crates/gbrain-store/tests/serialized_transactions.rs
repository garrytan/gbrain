//! The `serialized_transactions` capability and the lock-skip sites that rely on it.
//!
//! Every store fn that skips a lock a SQL engine takes (a row lock, an advisory lock, `SKIP LOCKED`,
//! a page-key lock) asserts `Store::assert_serialized_transactions` first. On a store whose `Kv` does
//! not hold the whole writer for an explicit transaction, each of them must refuse
//! `engine_capability_missing` naming its site, before it reads or writes anything. On a normal store
//! none of them refuses.

mod common;

use common::{TempDir, open, open_concurrent};
use gbrain_store::facts::FenceContext;
use gbrain_store::kv::Unserialized;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Kv, OpenOptions, Store, SystemEnv};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fmt::Debug;
use std::path::Path;
use std::sync::Arc;

const MISSING: &str = "engine_capability_missing";

/// A brain opened through the public seam `OpenOptions::withhold_serialized_transactions`: the store
/// is the same, but it promises no `serialized_transactions`.
fn unserialized(dir: &Path) -> Store {
    Store::open_dir(
        dir,
        OpenOptions {
            withhold_serialized_transactions: true,
            ..OpenOptions::default()
        },
    )
    .unwrap()
}

/// Builds the argument a store fn takes from its JSON form, as the binding does.
fn args<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

/// The call refuses `engine_capability_missing`, its message names `site` first, and it wrote
/// nothing (the store's commit sequence did not move).
fn refuses<T: Debug>(
    store: &Store,
    site: &str,
    call: impl FnOnce(&Store) -> gbrain_store::Result<T>,
) {
    let before = store.commit_version().unwrap();
    let err = call(store).expect_err(&format!("{site} ran on a store that cannot serialize"));
    assert_eq!(
        store.commit_version().unwrap(),
        before,
        "{site} wrote before it refused"
    );
    assert_eq!(err.code, MISSING, "{site}: {err:?}");
    let want = format!("serialized_transactions: {site} ");
    assert!(
        err.message.starts_with(&want),
        "{site}: message {:?} does not start with {want:?}",
        err.message
    );
}

/// The call does not refuse `engine_capability_missing` (it may fail or succeed otherwise).
fn accepts<T: Debug>(
    store: &Store,
    site: &str,
    call: impl FnOnce(&Store) -> gbrain_store::Result<T>,
) {
    if let Err(err) = call(store) {
        assert_ne!(err.code, MISSING, "{site} refused: {err:?}");
    }
}

/// A call that asks for no lock does not refuse, even on a store that cannot serialize.
fn unlocked_is_not_refused<T: Debug>(
    store: &Store,
    site: &str,
    call: impl FnOnce(&Store) -> gbrain_store::Result<T>,
) {
    accepts(store, site, call);
}

#[test]
fn a_normal_store_reports_serialized_transactions_in_both_modes() {
    let single = TempDir::new("serialized-single");
    let concurrent = TempDir::new("serialized-concurrent");
    assert!(open(&single).serialized_transactions());
    assert!(open_concurrent(&concurrent).serialized_transactions());
    let plain = TempDir::new("serialized-default");
    let options = OpenOptions {
        concurrent_writes: false,
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&plain.path().join("brain"), options).unwrap();
    assert!(store.serialized_transactions());
    store
        .assert_serialized_transactions("anySite")
        .expect("a normal store passes the assertion");
}

#[test]
fn a_store_that_does_not_serialize_reports_it_and_refuses_the_assertion() {
    let dir = TempDir::new("serialized-off");
    let store = unserialized(dir.path());
    assert!(!store.serialized_transactions());
    refuses(&store, "anySite", |s| {
        s.assert_serialized_transactions("anySite")
    });
}

/// The open result carries the store's promise (`StoreInfo::serialized_transactions`), the field the
/// TypeScript engine reads at every open: true on a normal store in both modes, false through the seam.
#[test]
fn the_open_result_carries_the_store_promise() {
    let dir = TempDir::new("serialized-info");
    assert!(open(&dir).info().serialized_transactions);
    let dir = TempDir::new("serialized-info-concurrent");
    assert!(open_concurrent(&dir).info().serialized_transactions);
    let dir = TempDir::new("serialized-info-withheld");
    let store = unserialized(dir.path());
    assert!(!store.info().serialized_transactions);
    assert!(!store.serialized_transactions());
}

/// `kv::Unserialized` over any record store withholds only the capability: the same records read
/// and write, and the skips refuse.
#[test]
fn a_wrapped_record_store_keeps_its_records_and_withholds_the_capability() {
    let dir = TempDir::new("serialized-wrapped");
    let inner: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(
        Arc::new(Unserialized(inner)),
        Arc::new(SystemEnv),
        OpenOptions::default(),
    )
    .unwrap();
    store.set_config("probe", "1").unwrap();
    assert_eq!(store.get_config("probe").unwrap().as_deref(), Some("1"));
    assert!(!store.serialized_transactions());
    let err = store.assert_serialized_transactions("probe").unwrap_err();
    assert_eq!(err.code, MISSING);
}

fn unserialized_store() -> (TempDir, Store) {
    let dir = TempDir::new("serialized-refuse");
    let store = unserialized(dir.path());
    (dir, store)
}

#[test]
fn lock_active_access_tokens_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockActiveAccessTokens", |s| {
        s.lock_active_access_tokens(None, None)
    });
}

#[test]
fn lock_legacy_access_tokens_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockLegacyAccessTokens", |s| {
        s.lock_legacy_access_tokens()
    });
}

#[test]
fn lock_access_policy_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockAccessPolicy", |s| {
        s.lock_access_policy("default")
    });
}

#[test]
fn lock_dream_map_config_row_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockDreamMapConfigRow", |s| {
        s.lock_dream_map_config_row(&args(json!({"key": "k"})))
    });
}

#[test]
fn lock_reconcile_revision_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockReconcileRevision", |s| {
        s.lock_reconcile_revision(&args(
            json!({"sourceId": "default", "slug": "a", "revision": null}),
        ))
    });
}

#[test]
fn lock_segmented_generation_page_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockSegmentedGenerationPage", |s| {
        s.lock_segmented_generation_page(1)
    });
}

#[test]
fn lock_body_staging_state_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockBodyStagingState", |s| {
        s.lock_body_staging_state("00000000-0000-0000-0000-000000000000")
    });
}

#[test]
fn lock_page_keys_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockPageKeys", |s| s.lock_page_keys(&[]));
}

#[test]
fn select_claimable_effect_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "selectClaimableEffect", |s| {
        s.select_claimable_effect("host", &[])
    });
}

#[test]
fn claim_coalesced_git_effects_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "claimCoalescedGitEffects", |s| {
        s.claim_coalesced_git_effects(&args(json!({
            "hostId": "00000000-0000-0000-0000-000000000000",
            "worktreeId": "00000000-0000-0000-0000-000000000000",
            "limit": 1, "deadOwners": [], "ownerJson": "{}",
        })))
    });
}

#[test]
fn lock_held_concept_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockHeldConcept", |s| {
        s.lock_held_concept(1, "default", "concepts/a", "1", "owed-page-purge")
    });
}

#[test]
fn lock_live_concept_members_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockLiveConceptMembers", |s| {
        s.lock_live_concept_members("default", &[])
    });
}

#[test]
fn select_claimable_write_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "selectClaimableWrite", |s| {
        s.select_claimable_write(&gbrain_store::persistence::ClaimableSpec::default())
    });
}

#[test]
fn lock_effect_claim_row_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockEffectClaimRow", |s| s.lock_effect_claim_row(1));
}

#[test]
fn lock_effect_row_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockEffectRow", |s| s.lock_effect_row("1"));
}

#[test]
fn lock_noop_embedding_window_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockNoopEmbeddingWindow", |s| {
        s.lock_noop_embedding_window("", 1)
    });
}

#[test]
fn lock_persistence_counters_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockPersistenceCounters", |s| {
        s.lock_persistence_counters(&[])
    });
}

#[test]
fn lock_live_pages_by_key_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockLivePagesByKey", |s| {
        s.lock_live_pages_by_key(&[])
    });
}

#[test]
fn lock_fact_for_withdrawal_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockFactForWithdrawal", |s| {
        s.lock_fact_for_withdrawal(&args(
            json!({"id": 1, "sourceId": "default", "worldOnly": false}),
        ))
    });
}

#[test]
fn read_oauth_code_for_update_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "readOauthCodeForUpdate", |s| {
        s.read_oauth_code_for_update("hash", "client")
    });
}

#[test]
fn read_oauth_refresh_token_for_update_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "readOauthRefreshTokenForUpdate", |s| {
        s.read_oauth_refresh_token_for_update("hash", "client")
    });
}

#[test]
fn assert_cycle_lease_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "assertCycleLease", |s| {
        s.assert_cycle_lease("lock", "00000000-0000-0000-0000-000000000000")
    });
}

#[test]
fn read_page_revision_for_share_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "readPageRevisionForShare", |s| {
        s.read_page_revision_for_share("default", "a")
    });
}

#[test]
fn lock_registered_source_ids_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockRegisteredSourceIds", |s| {
        s.lock_registered_source_ids(&[])
    });
}

#[test]
fn lock_overdue_hold_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "lockOverdueHold", |s| {
        s.lock_overdue_hold("refresh", None, None, 0.0)
    });
}

#[test]
fn list_git_effects_carrying_reason_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listGitEffectsCarryingReason", |s| {
        s.list_git_effects_carrying_reason(&args(
            json!({"sourceId": "default", "needle": "n", "escaped": "n", "foldedJson": "n"}),
        ))
    });
}

#[test]
fn list_page_git_effects_for_strip_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listPageGitEffectsForStrip", |s| {
        s.list_page_git_effects_for_strip(&args(json!({"sourceId": "default", "slug": "a"})))
    });
}

#[test]
fn list_held_rows_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listHeldRows", |s| {
        s.list_held_rows(
            &args(json!({"table": "takes", "pageId": 1, "ids": [1]})),
            &FenceContext::default(),
        )
    });
}

#[test]
fn list_held_take_rows_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listHeldTakeRows", |s| {
        s.list_held_take_rows(&args(json!({"ids": [1]})), &FenceContext::default())
    });
}

#[test]
fn list_held_timeline_rows_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listHeldTimelineRows", |s| {
        s.list_held_timeline_rows(&args(json!({"ids": [1]})), &FenceContext::default())
    });
}

#[test]
fn list_guarded_take_rows_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listGuardedTakeRows", |s| {
        s.list_guarded_take_rows(&args(json!({})), &FenceContext::default())
    });
}

#[test]
fn read_pair_fact_row_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "readPairFactRow", |s| {
        s.read_pair_fact_row(&args(json!({"id": 1, "lock": true})))
    });
    unlocked_is_not_refused(&store, "readPairFactRow", |s| {
        s.read_pair_fact_row(&args(json!({"id": 1})))
    });
}

#[test]
fn read_replacement_target_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "readReplacementTarget", |s| {
        s.read_replacement_target(&args(
            json!({"targetId": 1, "sourceId": "default", "lock": true}),
        ))
    });
    unlocked_is_not_refused(&store, "readReplacementTarget", |s| {
        s.read_replacement_target(&args(json!({"targetId": 1, "sourceId": "default"})))
    });
}

#[test]
fn list_origin_claims_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    refuses(&store, "listOriginClaims", |s| {
        s.list_origin_claims("default", &[], &args(json!({"lockKeys": ["origin"]})))
    });
    unlocked_is_not_refused(&store, "listOriginClaims", |s| {
        s.list_origin_claims("default", &[], &args(json!({})))
    });
}

/// `holdPageKeys` needs an open transaction, which the store still begins.
#[test]
fn hold_page_keys_refuses_on_a_store_that_does_not_serialize() {
    let (_dir, store) = unserialized_store();
    let tx = store.begin_transaction(false).unwrap();
    refuses(&tx, "holdPageKeys", |s| s.hold_page_keys(&[], false));
    tx.rollback_transaction().unwrap();
}

fn calls_on_a_normal_store(store: Store) {
    accepts(&store, "lockActiveAccessTokens", |s| {
        s.lock_active_access_tokens(None, None)
    });
    accepts(&store, "lockLegacyAccessTokens", |s| {
        s.lock_legacy_access_tokens()
    });
    accepts(&store, "lockAccessPolicy", |s| {
        s.lock_access_policy("default")
    });
    accepts(&store, "lockDreamMapConfigRow", |s| {
        s.lock_dream_map_config_row(&args(json!({"key": "k"})))
    });
    accepts(&store, "lockReconcileRevision", |s| {
        s.lock_reconcile_revision(&args(
            json!({"sourceId": "default", "slug": "a", "revision": null}),
        ))
    });
    accepts(&store, "lockSegmentedGenerationPage", |s| {
        s.lock_segmented_generation_page(1)
    });
    accepts(&store, "lockBodyStagingState", |s| {
        s.lock_body_staging_state("00000000-0000-0000-0000-000000000000")
    });
    accepts(&store, "lockPageKeys", |s| s.lock_page_keys(&[]));
    accepts(&store, "selectClaimableEffect", |s| {
        s.select_claimable_effect("host", &[])
    });
    accepts(&store, "selectClaimableWrite", |s| {
        s.select_claimable_write(&gbrain_store::persistence::ClaimableSpec::default())
    });
    accepts(&store, "claimCoalescedGitEffects", |s| {
        s.claim_coalesced_git_effects(&args(json!({
            "hostId": "00000000-0000-0000-0000-000000000000",
            "worktreeId": "00000000-0000-0000-0000-000000000000",
            "limit": 1, "deadOwners": [], "ownerJson": "{}",
        })))
    });
    accepts(&store, "lockHeldConcept", |s| {
        s.lock_held_concept(1, "default", "concepts/a", "1", "owed-page-purge")
    });
    accepts(&store, "lockLiveConceptMembers", |s| {
        s.lock_live_concept_members("default", &[])
    });
    accepts(&store, "lockEffectClaimRow", |s| s.lock_effect_claim_row(1));
    accepts(&store, "lockEffectRow", |s| s.lock_effect_row("1"));
    accepts(&store, "lockNoopEmbeddingWindow", |s| {
        s.lock_noop_embedding_window("", 1)
    });
    accepts(&store, "lockPersistenceCounters", |s| {
        s.lock_persistence_counters(&[])
    });
    accepts(&store, "lockLivePagesByKey", |s| {
        s.lock_live_pages_by_key(&[])
    });
    accepts(&store, "lockFactForWithdrawal", |s| {
        s.lock_fact_for_withdrawal(&args(
            json!({"id": 1, "sourceId": "default", "worldOnly": false}),
        ))
    });
    accepts(&store, "readOauthCodeForUpdate", |s| {
        s.read_oauth_code_for_update("hash", "client")
    });
    accepts(&store, "readOauthRefreshTokenForUpdate", |s| {
        s.read_oauth_refresh_token_for_update("hash", "client")
    });
    accepts(&store, "assertCycleLease", |s| {
        s.assert_cycle_lease("lock", "00000000-0000-0000-0000-000000000000")
    });
    accepts(&store, "readPageRevisionForShare", |s| {
        s.read_page_revision_for_share("default", "a")
    });
    accepts(&store, "lockRegisteredSourceIds", |s| {
        s.lock_registered_source_ids(&[])
    });
    accepts(&store, "lockOverdueHold", |s| {
        s.lock_overdue_hold("refresh", None, None, 0.0)
    });
    accepts(&store, "listGitEffectsCarryingReason", |s| {
        s.list_git_effects_carrying_reason(&args(
            json!({"sourceId": "default", "needle": "n", "escaped": "n", "foldedJson": "n"}),
        ))
    });
    accepts(&store, "listPageGitEffectsForStrip", |s| {
        s.list_page_git_effects_for_strip(&args(json!({"sourceId": "default", "slug": "a"})))
    });
    accepts(&store, "listHeldRows", |s| {
        s.list_held_rows(
            &args(json!({"table": "takes", "pageId": 1, "ids": [1]})),
            &FenceContext::default(),
        )
    });
    accepts(&store, "listHeldTakeRows", |s| {
        s.list_held_take_rows(&args(json!({"ids": [1]})), &FenceContext::default())
    });
    accepts(&store, "listHeldTimelineRows", |s| {
        s.list_held_timeline_rows(&args(json!({"ids": [1]})), &FenceContext::default())
    });
    accepts(&store, "listGuardedTakeRows", |s| {
        s.list_guarded_take_rows(&args(json!({})), &FenceContext::default())
    });
    accepts(&store, "readPairFactRow", |s| {
        s.read_pair_fact_row(&args(json!({"id": 1, "lock": true})))
    });
    accepts(&store, "readReplacementTarget", |s| {
        s.read_replacement_target(&args(
            json!({"targetId": 1, "sourceId": "default", "lock": true}),
        ))
    });
    accepts(&store, "listOriginClaims", |s| {
        s.list_origin_claims("default", &[], &args(json!({"lockKeys": ["origin"]})))
    });
    let tx = store.begin_transaction(false).unwrap();
    accepts(&tx, "holdPageKeys", |s| s.hold_page_keys(&[], false));
    tx.rollback_transaction().unwrap();
}

#[test]
fn no_lock_skip_site_refuses_on_a_normal_store() {
    let dir = TempDir::new("serialized-accept");
    calls_on_a_normal_store(open(&dir));
    let concurrent = TempDir::new("serialized-accept-concurrent");
    calls_on_a_normal_store(open_concurrent(&concurrent));
}

/// Every `assert_serialized_transactions("<site>")` in `src/` has a refusal case above, and every
/// case above has its call in `src/`, so a site added without a test (or a test without a site)
/// fails here.
#[test]
fn the_cases_above_are_exactly_the_sites_in_the_source() {
    fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let marker = "self.assert_serialized_transactions(\"";
    let mut in_source = BTreeSet::new();
    let mut files = Vec::new();
    rust_files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    for file in files {
        for line in std::fs::read_to_string(&file).unwrap().lines() {
            if let Some(rest) = line.trim().strip_prefix(marker) {
                let site = rest.split('"').next().unwrap();
                assert!(in_source.insert(site.to_string()), "{site} asserted twice");
            }
        }
    }
    let mut in_tests = BTreeSet::new();
    for line in include_str!("serialized_transactions.rs").lines() {
        let line = line.trim();
        for kind in ["refuses(&store, \"", "refuses(&tx, \""] {
            if let Some(rest) = line.strip_prefix(kind) {
                in_tests.insert(rest.split('"').next().unwrap().to_string());
            }
        }
    }
    in_tests.remove("anySite");
    assert_eq!(in_source, in_tests);
    assert_eq!(in_source.len(), SITE_COUNT);
}

const SITE_COUNT: usize = 35;
